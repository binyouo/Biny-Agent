import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageTimeline } from "../src/desktop/renderer/src/components/MessageTimeline.js";
import { MessageContextMenu } from "../src/desktop/renderer/src/components/chat/MessageContextMenu.js";
import { WorkspaceToolsPanel } from "../src/desktop/renderer/src/components/workspace/WorkspaceToolsPanel.js";
import { skillActivities } from "../src/desktop/renderer/src/skillActivity.js";
import { buildSessionTimeline, type TimelineTurn } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { SessionEvent } from "../src/session/recorder.js";

const time = "2026-10-12T00:00:00.000Z";
const noop = (): void => undefined;
const noopAsync = (): Promise<void> => Promise.resolve();

test("successfully loaded skills appear in the context menu and failed Skill reads stay out", () => {
  const events: SessionEvent[] = [
    { type: "user_message", messageId: "user", content: "Review this change", time },
    { type: "message_metadata", messageId: "user", metadata: {
      capabilitySelection: { tools: ["Read", "Skill"], skills: ["review-id"] },
      loadedSkills: ["review"]
    } },
    { type: "tool_call", messageId: "user", toolCallId: "failed-skill", tool: "Skill", args: { skill: "broken" }, time },
    { type: "tool_result", messageId: "user", toolCallId: "failed-skill", tool: "Skill", result: { error: "Skill file changed" }, executionStatus: "failed", time },
    { type: "assistant_message", messageId: "assistant", replyToMessageId: "user", content: "Reviewed.", time }
  ];
  const turns = buildSessionTimeline(events, []);
  assert.deepEqual(turns[0]?.skills, ["review"], "metadata records only skills whose prompt body was assembled successfully");
  const markup = renderTimeline(turns);
  assert.doesNotMatch(markup, /chat-loaded-skills|本轮已加载技能/u, "loaded skills are not repeated below the assistant reply");
  assert.match(renderContextMenu(turns[0]?.skills ?? []), /0 个工具 · 1 个技能/u, "the context menu summarizes the successfully loaded skill");
  assert.doesNotMatch(renderContextMenu(turns[0]?.skills ?? []), /broken/u, "a failed Skill call remains out of the loaded list");
});

test("successful prompt preparation publishes skills to the live timeline", () => {
  const liveEvents = [
    { sessionId: "session", runId: "run", timestamp: time, type: "message.user", messageId: "user", content: "Review this change" },
    { sessionId: "session", runId: "run", timestamp: time, type: "run.started", messageId: "assistant", model: { alias: "test", provider: "test", label: "test", reasoning: "" } },
    { sessionId: "session", runId: "run", timestamp: time, type: "context.updated", context: {
      capabilitySelection: { tools: ["Read"], skills: ["review-id"] }, loadedSkills: ["review"], memoryInjectedSummaries: []
    } }
  ] as unknown as AgentHostEvent[];
  const turns = buildSessionTimeline([], liveEvents);
  assert.deepEqual(turns[0]?.skills, ["review"]);
  assert.doesNotMatch(renderTimeline(turns), /chat-loaded-skills/u, "live prompt preparation no longer creates a second visible skill list");
  assert.match(renderContextMenu(turns[0]?.skills ?? []), /0 个工具 · 1 个技能/u);
});

test("successful Skill tool results enter the loaded list", () => {
  const turns = buildSessionTimeline([
    { type: "user_message", messageId: "user", content: "Read the skill", time },
    { type: "tool_call", messageId: "user", toolCallId: "skill", tool: "Skill", args: { skill: "references" }, time },
    { type: "tool_result", messageId: "user", toolCallId: "skill", tool: "Skill", result: "Reference instructions", executionStatus: "succeeded", time },
    { type: "assistant_message", messageId: "assistant", replyToMessageId: "user", content: "Done", time }
  ], []);
  assert.deepEqual(turns[0]?.skills, ["references"]);
  assert.match(renderContextMenu(turns[0]?.skills ?? []), /0 个工具 · 1 个技能/u, "successful Skill reads remain visible in the context menu");
});

test("selected, injected and failed skills remain distinguishable after replay and live updates", () => {
  const history: SessionEvent[] = [
    { type: "user_message", messageId: "user", content: "Review", time },
    { type: "message_metadata", messageId: "user", metadata: { capabilitySelection: { tools: ["Skill"], skills: ["review-id", "broken"] }, loadedSkills: ["image-gen"] } },
    { type: "tool_call", messageId: "user", toolCallId: "skill", tool: "Skill", args: { skill: "broken" }, time },
    { type: "tool_result", messageId: "user", toolCallId: "skill", tool: "Skill", result: { error: "Skill file changed" }, executionStatus: "failed", time }
  ];
  const live = [
    { sessionId: "session", runId: "run", timestamp: time, type: "message.user", messageId: "user", content: "Review" },
    { sessionId: "session", runId: "run", timestamp: time, type: "run.started", messageId: "assistant", model: { alias: "test", provider: "test", label: "test", reasoning: "" } },
    { sessionId: "session", runId: "run", timestamp: time, type: "context.updated", context: { capabilitySelection: { tools: ["Skill"], skills: ["review-id", "broken"] }, loadedSkills: ["image-gen"], memoryInjectedSummaries: [] } },
    { sessionId: "session", runId: "run", timestamp: time, type: "tool.started", toolCallId: "skill", tool: "Skill", args: { skill: "broken" } },
    { sessionId: "session", runId: "run", timestamp: time, type: "tool.failed", toolCallId: "skill", tool: "Skill", result: { error: "Skill file changed" }, error: "Skill file changed", executionStatus: "failed" }
  ] as unknown as AgentHostEvent[];
  const labels = new Map([["review-id", "review"]]);
  for (const turn of [buildSessionTimeline(history, [])[0]!, buildSessionTimeline([], live)[0]!]) {
    assert.deepEqual(turn.skills, ["image-gen"]);
    const activities = skillActivities(turn.skills, turn.capabilitySelection?.skills, turn.tools, labels);
    assert.deepEqual(activities, [
      { name: "review", status: "selected" },
      { name: "broken", status: "failed", error: "Skill file changed" },
      { name: "image-gen", status: "loaded" }
    ]);
    const panel = renderToStaticMarkup(createElement(WorkspaceToolsPanel, { tools: turn.tools, skills: activities }));
    assert.match(panel, /review<\/span><small>已选中/u);
    assert.match(panel, /broken<\/span><small>加载失败/u);
    assert.match(panel, /image-gen<\/span><small>已加载/u);
    assert.match(panel, /Skill file changed/u);
    assert.equal((panel.match(/data-tool-call-id=/gu) ?? []).length, 1, "injected and selected skills do not create tool calls");
    assert.match(renderToStaticMarkup(createElement(MessageContextMenu, {
      tools: ["Skill"], skills: turn.skills, selectedSkills: turn.capabilitySelection?.skills, skillCalls: turn.tools, skillLabels: labels
    })), /0 个工具 · 3 个技能/u);
  }
});

test("skill activity follows loading and retry outcomes without expanding automatic selections", () => {
  for (const selection of ["auto", "all", "none"] as const) assert.deepEqual(skillActivities([], selection, []), []);
  const call = { id: "skill", tool: "Skill", args: { skill: "review" }, updates: [] };
  for (const [status, expected] of [["running", "running"], ["waiting", "waiting"], ["denied", "denied"], ["cancelled", "cancelled"], ["unknown", "unknown"], ["success", "loaded"]] as const) {
    assert.equal(skillActivities([], ["review"], [{ ...call, status }])[0]?.status, expected);
  }
  const failed = { ...call, id: "failed", status: "failed" as const, error: "Read failed" };
  const succeeded = { ...call, status: "success" as const };
  const script = { ...call, id: "script", tool: "run_script", status: "failed" as const, children: [succeeded] };
  assert.deepEqual(skillActivities([], ["review"], [failed, script, succeeded]), [{ name: "review", status: "loaded", error: undefined }]);
  assert.deepEqual(skillActivities(["review"], ["review"], [failed]), [{ name: "review", status: "loaded" }]);
});

function renderTimeline(turns: TimelineTurn[]): string {
  return renderToStaticMarkup(createElement(MessageTimeline, {
    sessionId: "session", projectId: "project", turns,
    onPreviewFile: noop, onOpenExternal: noop, onReferenceMessage: noop, onShowMessageReferences: noop,
    onAddQuoteToConversation: noopAsync, onResolvePermission: noopAsync, thinking: false,
    onRetry: noopAsync, onSwitchVersion: noopAsync, onEditRequest: noop, onRollbackFiles: noop
  }));
}

function renderContextMenu(skills: readonly string[]): string {
  return renderToStaticMarkup(createElement(MessageContextMenu, { skills, tools: [] }));
}
