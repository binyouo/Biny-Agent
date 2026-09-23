/** 问候不生成日记；畸形思考协议在完整消息和任意流式分片中都不能进入正文。 */
import assert from "node:assert/strict";
import { publicAssistantMessage } from "../src/session/publicMessage.js";
import { buildSessionTimeline, createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { SessionEvent } from "../src/session/recorder.js";
const raw = "hey~ what's up?\n\n</think>\n\nPrivate analysis that must not appear";
assert.equal(publicAssistantMessage(raw).trim(), "hey~ what's up?");
for (let end = 1; end <= raw.length; end++) assert.doesNotMatch(publicAssistantMessage(raw.slice(0, end)), /<\/t|Private analysis/u);
assert.equal(publicAssistantMessage("<think>internal\nthought</think>hello"), "hello");
assert.equal(publicAssistantMessage("```xml\n<think>example</think>\n```"), "```xml\n<think>example</think>\n```");
assert.equal(publicAssistantMessage("Use `</think>` as a delimiter."), "Use `</think>` as a delimiter.");
const events: SessionEvent[] = [
  { type: "user_message", content: "hi", messageId: "user" },
  { type: "tool_call", tool: "ToolSearch", toolCallId: "search-1", args: {}, assistantContent: raw },
  { type: "tool_result", tool: "ToolSearch", toolCallId: "search-1", result: { error: "Insufficient Balance" }, executionStatus: "failed" },
  { type: "tool_call", tool: "ToolSearch", toolCallId: "search-2", args: {}, assistantContent: raw },
  { type: "tool_result", tool: "ToolSearch", toolCallId: "search-2", result: { error: "Insufficient Balance" }, executionStatus: "failed" },
  { type: "assistant_message", content: raw, messageId: "answer", replyToMessageId: "user" },
  { type: "message_metadata", messageId: "answer", metadata: { diaryPath: "/home/example/.config/biny/memory/2026-09-22.md" } },
  { type: "turn_status", status: "completed", stopReason: "model_stop", steps: 1 }
];
for (const turns of [buildSessionTimeline(events, []), createSessionTimelineProjector().update({ sessionId: "test", events, liveEvents: [] })]) {
 assert.equal(turns.at(-1) && "diaryPath" in turns.at(-1)!, false, "旧版无条件生成的日记关联不能作为真实文件产出展示");
 assert.equal(turns.at(-1)?.assistant.trim(), "hey~ what's up?");
 assert.equal(turns.at(-1)?.tools.length, 2, "真实失败工具记录不能被去重隐藏");
 assert.equal(turns.at(-1)?.steps.filter((step) => step.kind === "assistant").length, 1, "重复的工具前说明不再次呈现最终答复");
}
console.log("greeting output regressions passed");
