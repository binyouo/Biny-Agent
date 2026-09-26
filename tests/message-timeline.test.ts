/** 从真实事件投影到消息组件，验证空失败、部分输出和历史回放的展示边界。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { GenerationErrorBanner } from "../src/desktop/renderer/src/components/chat/GenerationErrorBanner.js";
import { MessageTimeline } from "../src/desktop/renderer/src/components/MessageTimeline.js";
import { buildSessionTimeline, type TimelineTurn } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { SessionEvent } from "../src/session/events.js";

const base = { sessionId: "session", runId: "run", timestamp: "2026-09-11T00:00:00.000Z" };
const start: AgentHostEvent[] = [
  { ...base, type: "message.user", messageId: "user-message", content: "检查项目" },
  { ...base, type: "reasoning.started", phase: "initial" }
];
const failure: AgentHostEvent = { ...base, timestamp: "2026-09-11T00:00:12.000Z", type: "run.failed", error: "Connection timed out", durationMs: 12_000 };
const noop = (): void => undefined;
const noopAsync = (): Promise<void> => Promise.resolve();

function renderTurns(turns: TimelineTurn[], thinking = false, runtimeActiveRunId?: string): string {
  return renderToStaticMarkup(createElement(MessageTimeline, {
    projectId: "project",
    turns,
    thinking,
    runtimeActiveRunId,
    onPreviewFile: noop,
    onOpenExternal: noop,
    onResolvePermission: noopAsync,
    onRetry: noopAsync,
    onSwitchVersion: noopAsync,
    onEditRequest: noop,
    onCreateBranch: noop,
    onRollbackFiles: noop,
    onDeleteUserMessage: noop
  }));
}

test("模型尚未输出就失败：只保留用户消息，不生成助手错误回复", () => {
  const turns = buildSessionTimeline([], [...start, failure]);
  assert.equal(turns[0]?.reasoningDurationMs, 12_000, "展示筛选不改写真实计时记录");
  const markup = renderTurns(turns.map((turn) => ({
    ...turn,
    capabilitySelection: { tools: ["Read"], skills: ["browser"] },
    memoryInjectedCount: 1,
    memoryInjectedSummaries: ["失败轮次不应展示这条记忆"]
  })));
  assert.match(markup, /检查项目/u);
  assert.doesNotMatch(markup, /Connection timed out|chat-run-notice/u);
  assert.match(markup, /aria-label="重新生成"/u);
  assert.doesNotMatch(markup, /data-sender="assistant"|技术详情/u);
  assert.doesNotMatch(markup, /已思考|chat-activity|Worked for|assistant-actions|复制回复|更多回复操作/u);
  assert.doesNotMatch(markup, /chat-meta-indicator|1 条记忆|1 个工具|1 个技能/u);
});

test("中断上下文标记不作为用户消息展示", () => {
  const marker = "<turn_aborted>hidden model context</turn_aborted>";
  const turns = buildSessionTimeline([
    { type: "user_message", content: "停止前的请求", messageId: "user-message", time: base.timestamp },
    { type: "turn_interrupted", reason: "interrupted", content: marker, time: "2026-09-11T00:00:01.000Z" },
    { type: "turn_status", status: "cancelled", stopReason: "interrupted", steps: 0, time: "2026-09-11T00:00:02.000Z" }
  ], []);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.user, "停止前的请求");
  assert.doesNotMatch(renderTurns(turns), /hidden model context/u);
});

test("后台通知 XML 不进入实时或历史消息界面", () => {
  const notification = "<biny_notification>修复完成。</biny_notification>";
  const historical = buildSessionTimeline([
    { type: "user_message", content: "修复问题", messageId: "user-message", time: base.timestamp },
    { type: "assistant_message", content: `正文内容。\n\n${notification}`, messageId: "assistant-message", time: "2026-09-11T00:00:01.000Z" }
  ], []);
  assert.equal(historical[0]?.assistant, "正文内容。");
  assert.doesNotMatch(renderTurns(historical), /biny_notification|修复完成/u);

  const live = buildSessionTimeline([], [
    { ...base, type: "message.user", messageId: "live-user", content: "修复问题" },
    { ...base, type: "run.started", messageId: "live-assistant", model: { alias: "test", provider: "test", label: "test", reasoning: "" } },
    { ...base, type: "assistant.delta", content: "正文内容。\n\n<bin" },
    { ...base, type: "assistant.delta", content: "y_notification>修复完成。" }
  ]);
  assert.equal(live[0]?.assistant, "正文内容。");
  assert.doesNotMatch(renderTurns(live), /biny_notification|修复完成/u);
});

test("记忆召回降级保留在回合元数据，不占用回复顶部", () => {
  const history: SessionEvent[] = [
    { type: "user_message", content: "检查项目", messageId: "user-message", time: "2026-09-11T00:00:00.000Z" },
    {
      type: "assistant_message",
      content: "已完成检查。",
      messageId: "assistant-message",
      time: "2026-09-11T00:00:10.000Z",
      metadata: { memoryRecallDegraded: "model_mismatch" }
    }
  ];
  const turns = buildSessionTimeline(history, []);
  const completed = turns.find((turn) => turn.memoryRecallDegraded !== undefined);
  assert.ok(completed, "会话时间线必须解析 assistant_message 元数据中的降级原因");
  assert.equal(completed.memoryRecallDegraded, "model_mismatch");
  const markup = renderTurns(turns);
  assert.doesNotMatch(markup, /chat-meta-indicator|记忆召回降级/u);
});

test("历史失败只有请求耗时：不能用总耗时生成思考步骤", () => {
  const markup = renderTurns(buildSessionTimeline([
    { type: "user_message", content: "检查项目", messageId: "user-message", time: base.timestamp },
    { type: "error", message: "Connection timed out", time: failure.timestamp }
  ], []));
  assert.doesNotMatch(markup, /Connection timed out|chat-run-notice/u);
  assert.doesNotMatch(markup, /data-sender="assistant"/u);
  assert.doesNotMatch(markup, /已思考|Worked for|chat-activity/u);
});

test("部分回复后失败：保留已收到的正文、真实思考和工具结果", () => {
  const turns = buildSessionTimeline([], [
    ...start,
    { ...base, type: "reasoning.delta", content: "先检查项目入口。" },
    { ...base, type: "tool.started", toolCallId: "read", tool: "Read", args: { path: "package.json" } },
    { ...base, type: "tool.completed", toolCallId: "read", tool: "Read", result: { content: "{}" }, durationMs: 20 },
    { ...base, type: "assistant.delta", content: "已读取项目配置。" },
    failure
  ]);
  const markup = renderTurns(turns.map((turn) => ({
    ...turn,
    capabilitySelection: { tools: ["Read"], skills: ["browser"] },
    memoryInjectedCount: 1,
    memoryInjectedSummaries: ["失败轮次不应展示这条记忆"]
  })));
  assert.match(markup, /已读取项目配置。/u);
  assert.match(markup, /chat-activity/u);
  assert.equal(turns[0]?.tools[0]?.status, "success");
  assert.equal(turns[0]?.reasoning, "先检查项目入口。");
  assert.doesNotMatch(markup, /Connection timed out|chat-run-notice/u);
  assert.match(markup, /复制回复/u);
  assert.doesNotMatch(markup, /chat-meta-indicator|1 条记忆|1 个工具|1 个技能/u);
});

test("实时思考不截断长内容，并把思考中的围栏代码渲染为代码块", () => {
  const reasoning = `先检查入口。\n\n\`\`\`ts\nconst answer = 42;\n\`\`\`\n${"继续分析。".repeat(140)}`;
  const turns = buildSessionTimeline([], [
    ...start,
    { ...base, type: "reasoning.delta", content: reasoning }
  ]);
  assert.equal(turns[0]?.reasoning, reasoning);
  const markup = renderTurns(turns);
  assert.match(markup, /markdown-code-block/u);
  assert.match(markup, /markdown-code-language[\s\S]*>ts<\/span>/u);
  assert.match(markup, /继续分析。继续分析。/u);
});

test("仅有工具结果的失败不会补出思考或空助手操作栏", () => {
  const markup = renderTurns(buildSessionTimeline([], [
    ...start,
    { ...base, type: "tool.started", toolCallId: "read", tool: "Read", args: { path: "package.json" } },
    { ...base, type: "tool.completed", toolCallId: "read", tool: "Read", result: { content: "{}" } },
    failure
  ]));
  assert.match(markup, /chat-activity/u);
  assert.doesNotMatch(markup, /Connection timed out|chat-run-notice/u);
  assert.doesNotMatch(markup, /已思考|Worked for|assistant-actions/u);
});

test("只有工具产出的成功轮次保留活动记录，清单移入更多菜单", () => {
  const markup = renderTurns(buildSessionTimeline([], [
    ...start,
    { ...base, type: "tool.started", toolCallId: "read", tool: "Read", args: { path: "package.json" } },
    { ...base, type: "tool.completed", toolCallId: "read", tool: "Read", result: { content: "{}" } },
    { ...base, type: "run.completed", durationMs: 20 }
  ]));
  assert.doesNotMatch(markup, /chat-meta-indicator|1 个工具/u);
  assert.match(markup, /更多回复操作/u);
  assert.match(markup, /chat-activity/u);
  assert.match(markup, /工具调用 1 次/u);
  assert.doesNotMatch(markup, /条记忆|个技能/u);
});

test("成功回复没有思考内容：展示正文但不凭总耗时补出思考", () => {
  const markup = renderTurns(buildSessionTimeline([
    { type: "user_message", content: "检查项目", time: base.timestamp },
    { type: "assistant_message", content: "检查完成。", time: failure.timestamp }
  ], []));
  assert.match(markup, /检查完成。/u);
  assert.match(markup, /复制回复/u);
  assert.doesNotMatch(markup, /已思考|chat-run-notice/u);
});

test("历史真实思考走事件步骤，缺失思考耗时时不借用整轮耗时", () => {
  const markup = renderTurns(buildSessionTimeline([
    { type: "user_message", content: "检查项目", time: base.timestamp },
    { type: "assistant_message", content: "检查完成。", reasoningContent: "先检查入口。", time: failure.timestamp }
  ], []));
  assert.match(markup, /已思考/u);
  assert.match(markup, /检查完成。/u);
  assert.doesNotMatch(markup, /已思考 12 秒/u);
});

test("停止后不补错误回复，保留真实压缩通知", () => {
  const markup = renderTurns(buildSessionTimeline([], [
    ...start,
    { ...base, type: "context.retrying", attempt: 1, compactedMessages: 10 },
    { ...base, type: "run.cancelled", reason: "Cancelled by user.", durationMs: 1_000 }
  ]));
  assert.doesNotMatch(markup, /Cancelled by user|chat-run-notice/u);
  assert.match(markup, /compaction/u);
  assert.doesNotMatch(markup, /已思考|回复生成失败|Worked for/u);
});

test("运行中保留活动反馈，并禁止重试旧失败消息", () => {
  const running = renderTurns(buildSessionTimeline([], start).map((turn) => ({
    ...turn,
    capabilitySelection: { tools: ["Read"], skills: ["browser"] },
    memoryInjectedCount: 1,
    memoryInjectedSummaries: ["运行中的记忆摘要"]
  })), true);
  assert.match(running, /Thinking\.\.\./u);
  assert.doesNotMatch(running, /chat-meta-indicator|1 条记忆|个工具|个技能/u);
  assert.doesNotMatch(running, /chat-run-status-time/u);
  assert.doesNotMatch(running, /chat-activity/u);
  assert.doesNotMatch(running, /回复生成失败|assistant-actions/u);
  const busy = renderTurns(buildSessionTimeline([], [...start, failure]), true);
  assert.doesNotMatch(busy, /aria-label="重新生成"/u);
});

test("空失败版本仍能切回已有的回复版本", () => {
  const turns = buildSessionTimeline([], [...start, failure]);
  const markup = renderTurns(turns.map((turn) => ({ ...turn, assistantMessageId: "failed-version", versionIndex: 2, versionCount: 2 })));
  assert.match(markup, /message-version-switcher/u);
  assert.doesNotMatch(markup, /assistant-actions/u);
});

test("生成错误只在独立横幅显示原文、模型和关闭按钮", () => {
  const error = "Cannot connect to API: Client network socket disconnected before secure TLS connection was established";
  const markup = renderTurns(buildSessionTimeline([], [...start, { ...failure, error }]));
  assert.doesNotMatch(markup, /data-sender="assistant"|Cannot connect|技术详情/u);
  const banner = renderToStaticMarkup(createElement(GenerationErrorBanner, { error, model: "test-model", onDismiss: noop }));
  assert.match(banner, /role="alert"/u);
  assert.match(banner, /生成错误/u);
  assert.match(banner, /Cannot connect to API/u);
  assert.match(banner, /Model test-model/u);
  assert.match(banner, /关闭错误提示/u);
  assert.doesNotMatch(banner, /重试<|技术详情|复制错误|请检查/u);
});

test("错误横幅保留原文解释，去掉重复行和堆栈", () => {
  const banner = renderToStaticMarkup(createElement(GenerationErrorBanner, {
    error: "自定义服务错误\n自定义服务错误\n    at internalFunction (file:///app.js:1)", onDismiss: noop
  }));
  assert.equal(banner.match(/自定义服务错误/gu)?.length, 1);
  assert.doesNotMatch(banner, /internalFunction/u);
});

test("失败后正常再发一条消息：保留两条用户消息，不插入失败助手消息", () => {
  const markup = renderTurns(buildSessionTimeline([], [
    ...start, failure,
    { ...base, runId: "next-run", type: "message.user", messageId: "next-user", content: "再试一次" },
    { ...base, runId: "next-run", type: "reasoning.started", phase: "initial" }
  ]), true);
  assert.match(markup, /检查项目/u);
  assert.match(markup, /再试一次/u);
  assert.doesNotMatch(markup, /Connection timed out|生成错误/u);
  assert.equal(markup.match(/data-sender="assistant"/gu)?.length, 1, "仅新一轮活动占用助手区域");
});

for (const [stage, label] of [["skills", "正在分析 Skill"], ["tools", "正在分析工具"], ["workspace", "正在准备 workspace"], ["memory", "正在检索记忆"], ["compacting", "正在压缩上下文"]] as const) {
  test(`准备阶段实时显示并在完成或失败时清除：${stage}`, () => {
    const events: AgentHostEvent[] = [start[0]!, { ...base, type: "preparation.updated", stage }];
    const pattern = new RegExp(label.replace(/\./gu, "\\."));
    assert.match(renderTurns(buildSessionTimeline([], events), true), pattern);
    const ready = buildSessionTimeline([], [...events, { ...base, type: "preparation.updated", stage: "ready" }]);
    assert.equal(ready[0]?.preparationStage, undefined);
    assert.doesNotMatch(renderTurns(ready, true), pattern);
    const failed = buildSessionTimeline([], [...events, failure]);
    assert.equal(failed[0]?.preparationStage, undefined);
    assert.doesNotMatch(renderTurns(failed), pattern);
  });
}

test("首个运行事件前与只有用户消息时，始终显示准备反馈", () => {
  assert.match(renderTurns([], true), /role="status"[^>]*>Thinking\.\.\./u);
  const markup = renderTurns(buildSessionTimeline([], start.slice(0, 1)), true);
  assert.match(markup, /data-sender="assistant"/u);
  assert.equal((markup.match(/chat-run-status-orb/gu) ?? []).length, 1);
});

test("等待首个增量、思考增量、工具执行及工具间空档都有准确状态", () => {
  const events = [...start];
  let markup = renderTurns(buildSessionTimeline([], events));
  assert.match(markup, /Thinking\.\.\./u);
  assert.doesNotMatch(markup, /已思考/u);
  events.push({ ...base, type: "reasoning.delta", content: "检查配置" });
  markup = renderTurns(buildSessionTimeline([], events));
  assert.match(markup, /思考中/u);
  assert.match(markup, /Following the thread/u);
  assert.doesNotMatch(markup, /已思考/u);
  events.push({ ...base, type: "tool.started", toolCallId: "read", tool: "Read", args: { path: "package.json" } });
  markup = renderTurns(buildSessionTimeline([], events));
  assert.match(markup, /探索中/u);
  assert.match(markup, /is-suppressed/u);
  events.push({ ...base, type: "tool.completed", toolCallId: "read", tool: "Read", result: { content: "{}" } });
  markup = renderTurns(buildSessionTimeline([], events));
  assert.match(markup, /role="status"[^>]*>Following the thread/u);
  assert.doesNotMatch(markup, /is-suppressed/u);
  events.push({ ...base, type: "assistant.delta", content: "配置检查完成" });
  markup = renderTurns(buildSessionTimeline([], events));
  assert.match(markup, /配置检查完成/u);
  assert.match(markup, /is-suppressed/u);
  events.push({ ...base, type: "run.cancelled", reason: "Stopped", durationMs: 1_000 });
  assert.doesNotMatch(renderTurns(buildSessionTimeline([], events)), /chat-run-status|思考中|探索中|Following the thread/u);
});

test("待授权状态让位给授权卡片，终态移除运行反馈", () => {
  const turn = buildSessionTimeline([], start)[0]!;
  assert.match(renderTurns([{ ...turn, status: "waiting_permission" }]), /aria-hidden="true" class="chat-run-status[^"<>]*is-suppressed/u);
  for (const status of ["completed", "failed", "cancelled"] as const) {
    assert.doesNotMatch(renderTurns([{ ...turn, status }]), /chat-run-status/u);
  }
});

test("实时内容接管反馈，空档显示等待，较早活动段不再自动展开", () => {
  const events: AgentHostEvent[] = [...start, { ...base, type: "reasoning.delta", content: "第一段思考" }];
  let html = renderTurns(buildSessionTimeline([], events));
  assert.match(html, /role="status">思考中/u);
  assert.match(html, /aria-hidden="true" class="chat-run-status[^"<>]*is-suppressed/u);
  events.push({ ...base, type: "reasoning.completed" });
  html = renderTurns(buildSessionTimeline([], events));
  assert.match(html, /role="status"[^>]*>Following the thread/u);
  assert.doesNotMatch(html, /is-suppressed/u);
  // 助手说明隔开两段活动，只有最后一段自动跟随。
  events.push({ ...base, type: "assistant.delta", content: "接下来检查文件" });
  events.push({ ...base, type: "tool.started", toolCallId: "read", tool: "Read", args: { path: "package.json" } });
  html = renderTurns(buildSessionTimeline([], events));
  const sections = [...html.matchAll(/<section class="chat-activity[^>]+>/gu)].map((match) => match[0]);
  assert.equal(sections.length, 2);
  assert.doesNotMatch(sections[0]!, /is-open|data-running/u);
  assert.match(sections[1]!, /is-open.*data-running="true"/u);
  assert.match(html, /is-suppressed/u);
});

test("正文流结束但轮次未结束时恢复等待反馈，下一次输出接管", () => {
  const events: AgentHostEvent[] = [...start,
    { ...base, type: "assistant.delta", content: "准备检查入口" },
    { ...base, type: "assistant.completed", content: "准备检查入口" }
  ];
  let html = renderTurns(buildSessionTimeline([], events));
  assert.match(html, /role="status"[^>]*>Following the thread/u);
  assert.doesNotMatch(html, /with-streaming-cursor|is-suppressed/u);
  events.push({ ...base, type: "assistant.delta", content: "入口已经确认" });
  html = renderTurns(buildSessionTimeline([], events));
  assert.match(html, /is-suppressed/u);
  assert.equal((html.match(/with-streaming-cursor/gu) ?? []).length, 1);
});

test("messageId 对齐不受时间戳偏差影响：同一回合不渲染两遍", () => {
  // 真实回归场景：实时 message.user 的时间戳晚于落盘时间（时钟偏差/事件重发），
  // 旧的内容+时间匹配会失配，历史副本和实时副本各渲染一遍。
  const history: SessionEvent[] = [
    { type: "user_message", content: "构建一个harness agent", messageId: "user-message", time: "2026-09-18T03:34:07.000Z" },
    { type: "tool_call", tool: "Write", args: { path: "harness/errors.py" }, toolCallId: "call-1", time: "2026-09-18T03:38:14.000Z", runtime: { eventId: "e2", eventSeq: 2, runId: "run" } }
  ];
  const live: AgentHostEvent[] = [
    { ...base, timestamp: "2026-09-18T03:38:00.000Z", type: "message.user", messageId: "user-message", content: "构建一个harness agent" },
    { ...base, timestamp: "2026-09-18T03:38:20.000Z", type: "tool.started", toolCallId: "call-2", tool: "Write", args: { path: "harness/llm.py" } }
  ];
  const turns = buildSessionTimeline(history, live);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.user, "构建一个harness agent");
  assert.deepEqual(turns[0]?.tools.map((tool) => tool.id), ["call-2"], "落盘的工具调用由实时流接管，不重复出现");
});

test("实时流丢失 message.user 锚点时按 runId 截断，用户气泡保留在历史段", () => {
  const history: SessionEvent[] = [
    { type: "user_message", content: "构建一个harness agent", messageId: "user-message", time: "2026-09-18T03:34:07.000Z", runtime: { eventId: "e1", eventSeq: 1, runId: "run" } },
    { type: "tool_call", tool: "Write", args: { path: "harness/errors.py" }, toolCallId: "call-1", time: "2026-09-18T03:38:14.000Z", runtime: { eventId: "e2", eventSeq: 2, runId: "run" } }
  ];
  // 草稿首发的头部事件被丢掉后，实时流里没有 message.user，只剩工具事件能证明 runId 归属。
  const live: AgentHostEvent[] = [
    { ...base, type: "tool.started", toolCallId: "call-2", tool: "Write", args: { path: "harness/llm.py" } },
    { ...base, type: "tool.completed", toolCallId: "call-2", tool: "Write", result: { status: "succeeded" } }
  ];
  const turns = buildSessionTimeline(history, live);
  assert.deepEqual(turns.flatMap((turn) => turn.tools.map((tool) => tool.id)), ["call-2"], "runId 对齐截断后工具调用不重复出现");
  assert.equal(turns[0]?.user, "构建一个harness agent");
  assert.equal(turns[1]?.user, "");
});

test("回合状态停在 idle 时由 runtime 活动 run 兜底，不渲染完成态操作栏", () => {
  // message.user 和 run.started 都被丢掉时，live 回合状态停在 idle；没有兜底就会按完成态渲染操作行和产出卡。
  const turn = buildSessionTimeline([], [
    { ...base, type: "reasoning.started", phase: "initial" },
    { ...base, type: "tool.started", toolCallId: "read", tool: "Read", args: { path: "package.json" } },
    { ...base, type: "tool.completed", toolCallId: "read", tool: "Read", result: { content: "{}" } },
    { ...base, type: "assistant.delta", content: "检查完成" }
  ])[0]!;
  assert.equal(turn.status, "idle");
  const stale = renderTurns([{ ...turn, assistant: "检查完成" }]);
  assert.match(stale, /assistant-actions/u);
  const live = renderTurns([{ ...turn, assistant: "检查完成" }], false, "run");
  assert.doesNotMatch(live, /assistant-actions/u);
  assert.match(live, /chat-run-status/u);
  // runtime 报告的 run 已结束（未传 runtimeActiveRunId）时恢复原判断。
  assert.match(renderTurns([{ ...turn, assistant: "检查完成", status: "completed" }]), /assistant-actions/u);
});
