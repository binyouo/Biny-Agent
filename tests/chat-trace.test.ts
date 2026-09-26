/** Trace 从会话请求记录投影，缺失指标不伪造，其他后台请求不混入主回合。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { SessionEvent } from "../src/session/recorder.js";
test("会话 Trace 保留真实请求和失败指标，排除记忆请求并按 requestId 去重", () => {
  const metrics = { requestId: "req1", provider: "local", modelId: "test", startedAt: "2026-09-25T00:00:00Z", durationMs: 900, attempts: [], eventCount: 1, finishReason: "error" as const, error: "unavailable", requestContext: { operation: "agent" as const, step: 1 }, usage: { inputTokens: 40, outputTokens: 2 } };
  const events: SessionEvent[] = [{ type: "user_message", content: "hi" }, { type: "model_request", metrics }, { type: "model_request", metrics }, { type: "model_request", metrics: { ...metrics, requestId: "memory", requestContext: { operation: "memory" } } }, { type: "assistant_message", content: "reply" }];
  const [turn] = buildSessionTimeline(events, []);
  assert.equal(turn?.modelRequests?.length, 1);
  assert.equal(turn?.modelRequests?.[0]?.error, "unavailable");
  assert.equal(turn?.modelRequests?.[0]?.usage?.inputTokens, 40);
  assert.equal(buildSessionTimeline([{ type: "user_message", content: "old" }, { type: "assistant_message", content: "reply" }], [])[0]?.modelRequests, undefined);
});
test("实时消息覆盖历史正文时仍保留同 run 的落盘 Trace", async () => {
  const { createSessionTimelineProjector } = await import("../src/desktop/renderer/src/sessionTimeline.js");
  const events: SessionEvent[] = [{ type: "user_message", messageId: "m", content: "hi" }, { type: "model_request", metrics: { requestId: "req", provider: "local", modelId: "test", startedAt: "2026-09-25T00:00:00Z", durationMs: 200, attempts: [], eventCount: 1, requestContext: { operation: "agent", runId: "run" } } }];
  const live = [{ type: "message.user" as const, sessionId: "s", runId: "run", timestamp: "2026-09-25T00:00:00Z", messageId: "m", content: "hi" }];
  assert.equal(buildSessionTimeline(events, live)[0]?.modelRequests?.[0]?.requestId, "req");
  const projector = createSessionTimelineProjector();
  const first = projector.update({ sessionId: "s", events, liveEvents: live });
  assert.equal(first[0]?.modelRequests?.[0]?.requestId, "req");
  assert.equal(projector.update({ sessionId: "s", events, liveEvents: live })[0], first[0]);
});
test("Trace 呈现真实失败和缺失指标，上下文菜单按实际调用去重", async () => {
  const React = await import("react"); Object.assign(globalThis, { React });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ExecutionTraceContent } = await import("../src/desktop/renderer/src/components/chat/ExecutionTraceDialog.js");
  const { MessageContextMenu } = await import("../src/desktop/renderer/src/components/chat/MessageContextMenu.js");
  const [turn] = buildSessionTimeline([{ type: "user_message", content: "hi" }, { type: "tool_call", toolCallId: "call", tool: "Bash", args: { command: "pwd" } }, { type: "tool_result", toolCallId: "call", tool: "Bash", result: { error: "failed proof", success: false } }], []);
  const html = renderToStaticMarkup(React.createElement(ExecutionTraceContent, { turn: turn! }));
  assert.match(html, /未记录模型请求明细/); assert.doesNotMatch(html, /failed proof|pwd|<details|未关联到模型步骤/);
  const menu = renderToStaticMarkup(React.createElement(MessageContextMenu, { tools: ["Bash", "Bash", "Skill"], skills: ["s", "s"] }));
  assert.match(menu, /上下文/); assert.match(menu, /2 个工具/); assert.match(menu, /1 个技能/);
});
test("请求步骤从本次 canonical 输出取得工具和正文，不把上批工具当成本次调用", () => {
  const metrics = { requestId: "step", provider: "p", modelId: "m", startedAt: "2026-09-25T12:52:00Z", durationMs: 2000, attempts: [], eventCount: 1, finishReason: "tool-calls" as const, requestContext: { runId: "r", operation: "agent" as const, relatedToolCallIds: ["previous"] } };
  const events: SessionEvent[] = [{ type: "user_message", content: "go" }, { type: "model_request", metrics }, { type: "agent_message", messageId: "output", runtime: { runId: "r", turnId: "t", eventId: "e", eventSeq: 1 }, message: { role: "assistant", stopReason: "tool-calls", content: [{ type: "toolCall", id: "current", name: "Read", arguments: {} }, { type: "text", text: "公开说明" }, { type: "reasoning", text: "不应作为正文预览" }] } }];
  events.splice(2, 0, { type: "model_request", metrics });
  const step = buildSessionTimeline(events, [])[0]?.modelRequests?.[0];
  assert.deepEqual(step?.output?.toolCalls, [{ id: "current", name: "Read" }]);
  assert.equal(step?.output?.textPreview, "公开说明");
  assert.equal((events[1] as Extract<SessionEvent,{type:"model_request"}>).metrics === metrics, true, "不改写持久化输入");
});
test("Trace 请求区间排除两次运行之间的等待，总 token 累加而 ctx 取最后请求", async () => {
  const React = await import("react"); Object.assign(globalThis, { React });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ExecutionTraceContent } = await import("../src/desktop/renderer/src/components/chat/ExecutionTraceDialog.js");
  const metrics = { requestId: "r1", provider: "p", modelId: "m", startedAt: "2026-09-25T12:00:00Z", durationMs: 2000, attempts: [], eventCount: 1, usage: {inputTokens:100, outputTokens:10,totalTokens:110}, requestContext:{runId:"a",operation:"agent" as const} };
  const [turn] = buildSessionTimeline([{ type:"user_message",content:"go" },{type:"model_request",metrics},{type:"model_request",metrics:{...metrics, requestId:"r2",startedAt:"2026-09-25T13:00:00Z",requestContext:{runId:"b",operation:"agent"},usage:{inputTokens:200,outputTokens:20,totalTokens:220}}},{type:"assistant_message",content:"done"}],[]);
  turn!.durationMs=3600000;
  const html = renderToStaticMarkup(React.createElement(ExecutionTraceContent,{turn:turn!}));
  assert.match(html,/4\.0s/); assert.match(html,/330 tok/); assert.match(html,/ctx 200/); assert.doesNotMatch(html,/60m|history-|<details|缓存命中|HTTP 状态|r1|r2/);
});
