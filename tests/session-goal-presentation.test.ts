import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionGoalPanel } from "../src/desktop/renderer/src/components/workspace/SessionGoalPanel.js";
import type { DesktopPlanProjection } from "../src/desktop/protocol.js";

const projection: DesktopPlanProjection = { sessionId: "session-a", plans: [], goal: {
  sessionId: "session-a", workspaceId: "workspace", goalId: "goal", objective: "完成原始目标\n保留全部约束", status: "active", tokenBudget: 1000,
  tokensUsed: 250, usageKnown: true, timeUsedMs: 30000, revision: 1, generation: 1, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z"
} };
const render = (sessionId = "session-a", value = projection) => renderToStaticMarkup(createElement(SessionGoalPanel, {
  sessionId, projection: value, onMutation: async () => undefined, onError: () => undefined
}));
const document = new JSDOM(render()).window.document;
const row = document.querySelector(".biny-session-goal-row");
assert.ok(row, "The current goal is visible as a complete row above the composer.");
assert.equal(row.querySelector('[role="status"]')?.textContent, "进行中的目标");
assert.equal(row.querySelector(".biny-session-goal-preview")?.textContent, projection.goal!.objective);
assert.ok(row.querySelector(".biny-session-goal-icon.is-active"), "Only active goals breathe.");
assert.equal(row.querySelectorAll(".biny-session-goal-icon circle").length, 3, "The target uses three concentric circles.");
assert.deepEqual([...row.querySelectorAll(".biny-session-goal-actions button")].map((button) => button.getAttribute("aria-label")), ["暂停目标", "编辑目标", "删除目标"]);
assert.ok(row.querySelector('[aria-label="查看完整目标"]'), "The truncated objective can be expanded without hiding its controls.");
assert.ok(document.querySelector(".biny-session-goal-details")?.hasAttribute("hidden"), "Details stay collapsed initially.");
assert.equal(document.querySelector(".biny-session-goal-objective")?.textContent, projection.goal!.objective);
assert.match(render(), /250 \/ 1,000/u);
assert.match(render("session-a", { ...projection, goal: { ...projection.goal!, usageKnown: false } }), /用量不完整/u);
assert.equal(render("session-b"), "");
assert.equal(render("session-a", { sessionId: "session-a", plans: [] }), "");
assert.equal(render("session-a", { ...projection, goal: { ...projection.goal!, sessionId: "session-b" } }), "");
const paused = render("session-a", { ...projection, goal: { ...projection.goal!, status: "paused", evidence: {
  summary: "自动续跑仅产生文字，已暂停以避免空转。", requirements: [{ requirement: "工作工具活动", evidence: "The last turn had no working tool." }]
} } });
assert.match(paused, /已暂停的目标/u);
assert.match(paused, /空转/u, "The pause reason remains available on the preview tooltip.");
assert.match(paused, /继续目标/u);
assert.doesNotMatch(paused, /is-active/u);
const blocked = render("session-a", { ...projection, goal: { ...projection.goal!, status: "blocked" } });
assert.match(blocked, /等待处理的目标/u);
assert.match(blocked, /继续目标/u);
assert.doesNotMatch(blocked, /is-active/u);
const limited = render("session-a", { ...projection, goal: { ...projection.goal!, status: "budget_limited" } });
assert.match(limited, /预算已用尽/u);
assert.doesNotMatch(limited, /继续目标|暂停目标|is-active/u);
assert.equal(render("session-a", { ...projection, goal: { ...projection.goal!, status: "completed" } }), "", "Completed goals leave the ongoing-goal row.");
console.log("session goal presentation tests passed");
