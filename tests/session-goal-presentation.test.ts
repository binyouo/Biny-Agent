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
const details = document.querySelector("details")!;
const summary = details.querySelector("summary")!;
assert.equal(summary.textContent, "目标", "The collapsed entry contains only its icon and short label.");
assert.ok(summary.querySelector("svg"), "The goal entry must have a target icon.");
assert.equal(details.hasAttribute("open"), false);
assert.ok(summary.getAttribute("aria-label")?.includes("持续执行中"), "Status remains accessible without filling the collapsed entry.");
assert.ok(details.querySelector('[role="status"]'));
assert.equal(document.querySelectorAll("button").length, details.querySelectorAll("button").length, "Goal controls appear inside the expanded details.");
assert.match(render(), /完成原始目标/u);
assert.match(render(), /保留全部约束/u);
assert.match(render(), /暂停/u);
assert.match(render(), /250 \/ 1,000/u);
assert.equal(render("session-b"), "");
assert.equal(render("session-a", { sessionId: "session-a", plans: [] }), "");
assert.match(render("session-a", { ...projection, goal: { ...projection.goal!, status: "paused" } }), /恢复/u);
const automaticallyPaused = render("session-a", { ...projection, goal: { ...projection.goal!, status: "paused", evidence: {
  summary: "自动续跑仅产生文字，已暂停以避免空转。", requirements: [{ requirement: "工作工具活动", evidence: "The last turn had no working tool." }]
} } });
assert.match(automaticallyPaused, /空转/u, "Expanded details must explain an automatic pause.");
assert.match(automaticallyPaused, /恢复/u);
const limited = render("session-a", { ...projection, goal: { ...projection.goal!, status: "budget_limited" } });
assert.match(limited, /预算已用尽/u);
assert.doesNotMatch(limited, />恢复</u);
assert.match(render("session-a", { ...projection, goal: { ...projection.goal!, usageKnown: false } }), /用量不完整/u);
console.log("session goal presentation tests passed");
